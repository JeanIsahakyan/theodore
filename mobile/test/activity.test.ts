import { describe, expect, it } from 'vitest';
import type { ChatMessage, TurnStep } from '../src/fleet/contract';
import { spaceReadOf } from '../src/fleet/rules';
import type { MirroredSubSpace } from '../src/gen/fleet';
import {
  activityBusy,
  activityHeadline,
  activityLine,
  activitySheet,
  progressLabel,
  showsActivity,
  stepLabel,
  subagentLabel,
  subagentsOf,
  trackTimes,
  turnSource,
} from '../src/ui/activity';
import {
  messageFrom,
  messageSide,
  readErrorText,
  subSpaceQuestion,
  subSpaceSendable,
  subSpaceSubtitle,
} from '../src/ui/subSpaceScreen';
import { subSpaceRows } from '../src/ui/subSpaceTree';

const tool = (
  over: Partial<Extract<TurnStep, { kind: 'tool' }>>,
): TurnStep => ({
  kind: 'tool',
  name: 'Read',
  target: null,
  ok: true,
  id: null,
  parent: null,
  detail: null,
  summary: null,
  added: null,
  removed: null,
  background: false,
  ...over,
});
const agent = (
  id: string,
  over: Partial<Extract<TurnStep, { kind: 'tool' }>> = {},
) => tool({ name: 'Task', id, detail: `Agent ${id}`, ok: null, ...over });

const msg = (
  over: Partial<ChatMessage> & Pick<ChatMessage, 'id'>,
): ChatMessage => ({
  pr: 'space:rs_1',
  author: { kind: 'agent', agent: 'claude' },
  text: '',
  at: 0,
  ...over,
});

const sub = (
  space: string,
  over: Partial<MirroredSubSpace> = {},
): MirroredSubSpace => ({
  space,
  parent: 'rs_1',
  title: space,
  status: 'running',
  mode: 'edit',
  done: false,
  ...over,
});
const byId = (...list: MirroredSubSpace[]) =>
  Object.fromEntries(list.map((s) => [s.space, s]));

describe('turnSource', () => {
  it('reads the live turn while it runs, else the last reply with steps', () => {
    const live = { run: 'r', steps: [agent('a')], since: null };
    expect(turnSource(live, [])).toEqual({ steps: live.steps, running: true });
    const messages = [
      msg({ id: 'm1', author: { kind: 'me' } }),
      msg({ id: 'm2', activity: [agent('a', { ok: true })] }),
      msg({ id: 'm3', author: { kind: 'me' } }),
      msg({ id: 'm4', activity: [] }),
    ];
    expect(turnSource(null, messages)).toEqual({
      steps: messages[1]!.activity,
      running: false,
    });
    expect(turnSource(null, [messages[0]!])).toBeNull();
  });
});

describe('subagentsOf', () => {
  it('lists top-level Task / Agent calls with an id, running while the turn does', () => {
    const steps: TurnStep[] = [
      tool({ name: 'Read', target: 'a.ts' }),
      agent('a'),
      agent('b', { name: 'Agent', ok: true }),
      agent('c', { ok: false }),
      agent('nested', { parent: 'a' }),
      agent('', { id: null }),
      tool({ name: 'Bash', id: 'x', detail: 'ls' }),
    ];
    expect(subagentsOf(steps, true)).toEqual([
      { call: 'a', description: 'Agent a', status: 'running' },
      { call: 'b', description: 'Agent b', status: 'done' },
      { call: 'c', description: 'Agent c', status: 'failed' },
    ]);
    // The turn ended: a call with no result is done.
    expect(subagentsOf(steps, false).map((a) => a.status)).toEqual([
      'done',
      'done',
      'failed',
    ]);
  });

  it('keeps a background one running until its summary lands', () => {
    const bg = agent('bg', { background: true, ok: true });
    expect(subagentsOf([bg], true)[0]!.status).toBe('running');
    const settled = agent('bg', {
      background: true,
      ok: true,
      summary: 'done it',
    });
    expect(subagentsOf([settled], true)[0]!.status).toBe('done');
    expect(
      subagentsOf([agent('d', { detail: '  ' })], true)[0]!.description,
    ).toBe('Subagent');
  });
});

describe('trackTimes and subagentLabel', () => {
  it('starts a call when first seen, ends it when it settles, keeps the rest', () => {
    const running = { call: 'a', description: 'A', status: 'running' as const };
    let t = trackTimes({}, [running], 1000);
    expect(t).toEqual({ a: { start: 1000 } });
    const same = trackTimes(t, [running], 5000);
    expect(same).toBe(t);
    expect(subagentLabel(running, t, 33_000)).toBe('running · 32s');
    t = trackTimes(t, [{ ...running, status: 'done' }], 65_000);
    expect(t).toEqual({ a: { start: 1000, end: 65_000 } });
    expect(subagentLabel({ ...running, status: 'done' }, t, 99_000)).toBe(
      'done · 1m 4s',
    );
    expect(trackTimes(t, [{ ...running, status: 'done' }], 99_000)).toBe(t);
  });

  it('a call seen only finished has no time to tell', () => {
    const done = { call: 'b', description: 'B', status: 'failed' as const };
    const t = trackTimes({}, [done], 7);
    expect(t).toEqual({ b: { start: 7, end: 7 } });
    expect(subagentLabel(done, t, 9)).toBe('failed');
    expect(subagentLabel(done, {}, 9)).toBe('failed');
  });
});

describe('line 1', () => {
  const progress = {
    steps: [
      { label: 'Read the flow', state: 'done' as const },
      { label: 'Edit auth', state: 'active' as const },
      { label: 'Tests', state: 'pending' as const },
    ],
    note: null,
    at: 0,
  };

  it('reads the plan: done of total, the active step, else the note', () => {
    expect(progressLabel(progress)).toBe('1 of 3 · Edit auth');
    const noActive = {
      ...progress,
      steps: progress.steps.map((s) => ({ ...s, state: 'done' as const })),
    };
    expect(progressLabel(noActive)).toBe('3 of 3');
    expect(progressLabel({ ...noActive, note: 'all green' })).toBe(
      '3 of 3 · all green',
    );
  });

  it('reads a step as its row does', () => {
    expect(stepLabel(tool({ name: 'Edit', target: 'auth.ts' }))).toBe(
      'Edit auth.ts',
    );
    expect(stepLabel(tool({ name: 'Bash', detail: 'Run the tests' }))).toBe(
      'Run the tests',
    );
    expect(stepLabel({ kind: 'thinking', text: 'hm' })).toBe('Thinking');
    expect(stepLabel({ kind: 'text', text: '\n  First line\nmore' })).toBe(
      'First line',
    );
    expect(stepLabel({ kind: 'text', text: '  ' })).toBeNull();
  });

  const base = {
    status: 'running' as const,
    question: false,
    progress: null,
    liveSteps: [],
    lastLog: null,
    queued: 0,
  };

  it('shows the plan first, then the newest live step, then the log, then Working', () => {
    expect(activityLine({ ...base, progress })).toEqual({
      text: '1 of 3 · Edit auth',
      live: true,
      waiting: false,
    });
    expect(
      activityLine({
        ...base,
        liveSteps: [
          tool({ name: 'Read', target: 'a.ts' }),
          { kind: 'text', text: '' },
          tool({ name: 'Edit', target: 'auth.ts' }),
        ],
      })!.text,
    ).toBe('Edit auth.ts');
    expect(activityLine({ ...base, lastLog: 'Bash cargo test' })!.text).toBe(
      'Bash cargo test',
    );
    expect(activityLine(base)!.text).toBe('Working');
  });

  it('counts the queue after the text', () => {
    expect(activityLine({ ...base, queued: 1 })!.text).toBe(
      'Working · 1 queued',
    );
    expect(activityLine({ ...base, progress, queued: 2 })!.text).toBe(
      '1 of 3 · Edit auth · 2 queued',
    );
  });

  it('waits on a question, and shows nothing when idle', () => {
    expect(
      activityLine({ ...base, status: 'waiting', question: true }),
    ).toEqual({
      text: 'Waiting for your answer ↓',
      live: false,
      waiting: true,
    });
    // A question while the row still says running (a host between events).
    expect(activityLine({ ...base, question: true })!.live).toBe(true);
    expect(activityLine({ ...base, status: 'idle' })).toBeNull();
    expect(activityLine({ ...base, status: 'failed', queued: 1 })).toBeNull();
  });
});

describe('line 2', () => {
  const agents = subagentsOf([agent('a'), agent('b', { ok: true })], true);

  it('counts agents and sub-spaces, with what runs or waits', () => {
    const rows = subSpaceRows(
      'rs_1',
      byId(
        sub('x', { status: 'question' }),
        sub('y', { status: 'idle', done: true }),
        sub('z'),
      ),
    );
    expect(activityHeadline(agents, rows)).toBe(
      '2 agents · 3 sub-spaces (1 running, 1 waiting)',
    );
    expect(activityHeadline([agents[0]!], [])).toBe('1 agent');
    expect(
      activityHeadline(
        [],
        subSpaceRows('rs_1', byId(sub('y', { done: true }))),
      ),
    ).toBe('1 sub-space');
    expect(activityHeadline([], [])).toBeNull();
  });

  it('is busy while an agent runs or a sub-space runs or waits', () => {
    const merged = subSpaceRows('rs_1', byId(sub('y', { done: true })));
    expect(activityBusy(agents, [])).toBe(true);
    expect(activityBusy([agents[1]!], merged)).toBe(false);
    expect(
      activityBusy(
        [],
        subSpaceRows('rs_1', byId(sub('x', { status: 'waiting' }))),
      ),
    ).toBe(true);
  });

  it('the strip shows with either line', () => {
    const line = { text: 'Working', live: true, waiting: false };
    expect(showsActivity(line, null)).toBe(true);
    expect(showsActivity(null, '1 agent')).toBe(true);
    expect(showsActivity(null, null)).toBe(false);
  });
});

describe('activitySheet', () => {
  it('lists the plan only while running, the turn title, agents and sub-spaces', () => {
    const progress = {
      steps: [{ label: 'Edit auth', state: 'active' as const }],
      note: null,
      at: 0,
    };
    const source = { steps: [agent('a')], running: true };
    const subs = byId(sub('x'));
    const v = activitySheet({
      status: 'running',
      progress,
      source,
      root: 'rs_1',
      subSpaces: subs,
    });
    expect(v.progress).toBe(progress);
    expect(v.turnTitle).toBe('This turn');
    expect(v.agents.map((a) => a.status)).toEqual(['running']);
    expect(v.subs.map((r) => r.sub.space)).toEqual(['x']);
    const idle = activitySheet({
      status: 'idle',
      progress,
      source: { ...source, running: false },
      root: 'rs_1',
      subSpaces: undefined,
    });
    expect(idle.progress).toBeNull();
    expect(idle.turnTitle).toBe('Last turn');
    expect(idle.agents.map((a) => a.status)).toEqual(['done']);
    expect(idle.subs).toEqual([]);
    expect(
      activitySheet({
        status: 'idle',
        progress: null,
        source: null,
        root: 'rs_1',
        subSpaces: {},
      }),
    ).toEqual({ progress: null, turnTitle: 'Last turn', agents: [], subs: [] });
  });
});

describe('spaceReadOf', () => {
  const full = {
    note: 'data',
    space: {
      space: 'a1b2c3d4e5f6',
      name: 'flaky',
      title: 'Fix the flaky test',
      project: 'p',
      status: 'question',
      mode: 'edit',
      agent: 'claude',
      turns: 3,
      done: false,
      updated_at: 1,
    },
    goal: 'Fix it',
    branch: 'agent/flaky',
    base: 'main',
    progress: [
      { label: 'Read', state: 'done' },
      { label: 'Edit', state: 'active' },
      { label: 'Odd', state: 'what' },
      'junk',
    ],
    progress_note: 'going',
    messages: [
      { from: 'user', at: 10, text: 'hi', truncated: false },
      { from: 'space:rs_1', at: 20, text: 'from the parent', truncated: true },
      { from: 'claude', at: 30, text: 'ok' },
      'junk',
    ],
    live: 'Editing…',
    question: {
      ask: 'ask-1',
      questions: [
        { question: 'Which?', options: ['a', 'b'], multi: false },
        { question: 7, options: 'x' },
      ],
    },
    diff: { files: 1, additions: 2, deletions: 3, paths: ['a'] },
    error: null,
  };

  it('takes every field it knows, shape-checked', () => {
    const r = spaceReadOf(full, 'a1b2c3d4e5f6')!;
    expect(r).toEqual({
      space: 'a1b2c3d4e5f6',
      title: 'Fix the flaky test',
      status: 'question',
      mode: 'edit',
      agent: 'claude',
      turns: 3,
      done: false,
      goal: 'Fix it',
      branch: 'agent/flaky',
      progress: [
        { label: 'Read', state: 'done' },
        { label: 'Edit', state: 'active' },
        { label: 'Odd', state: 'pending' },
      ],
      progressNote: 'going',
      messages: [
        { from: 'user', at: 10, text: 'hi', truncated: false },
        {
          from: 'space:rs_1',
          at: 20,
          text: 'from the parent',
          truncated: true,
        },
        { from: 'claude', at: 30, text: 'ok', truncated: false },
      ],
      live: 'Editing…',
      question: {
        ask: 'ask-1',
        questions: [
          { question: 'Which?', options: ['a', 'b'], multi: false },
          { question: '', options: [], multi: false },
        ],
      },
      error: null,
    });
  });

  it('refuses an answer about another space, or no object', () => {
    expect(spaceReadOf(full, 'other')).toBeNull();
    expect(spaceReadOf(null, 'a1b2c3d4e5f6')).toBeNull();
    expect(spaceReadOf({ space: 'a1b2c3d4e5f6' }, 'a1b2c3d4e5f6')).toBeNull();
  });

  it('falls back field by field: the name as title, unknown words, cut texts', () => {
    const r = spaceReadOf(
      {
        space: {
          space: 'a1b2c3d4e5f6',
          name: 'flaky',
          status: 'bogus',
          mode: 'god',
          turns: -1,
          agent: 7,
        },
        goal: 'x'.repeat(9000),
        messages: Array.from({ length: 60 }, (_, i) => ({
          from: 'user',
          at: i,
          text: String(i),
        })),
        question: { ask: '', questions: [] },
        live: 7,
      },
      'a1b2c3d4e5f6',
    )!;
    expect(r.title).toBe('flaky');
    expect(r.status).toBe('unknown');
    expect(r.mode).toBeNull();
    expect(r.agent).toBeNull();
    expect(r.turns).toBe(0);
    expect(r.goal).toHaveLength(8000);
    expect(r.messages).toHaveLength(50);
    expect(r.messages[0]!.at).toBe(10);
    expect(r.question).toBeNull();
    expect(r.live).toBeNull();
    expect(r.progress).toEqual([]);
    expect(r.error).toBeNull();
  });
});

describe('the sub-space screen', () => {
  it('says whose sub-space it is, where, and how it stands', () => {
    expect(
      subSpaceSubtitle({
        parentTitle: 'Retry on 429',
        hostName: 'mac-A',
        status: 'question',
        done: false,
      }),
    ).toBe('sub-space of Retry on 429 · on mac-A · Waiting for you');
    expect(
      subSpaceSubtitle({
        parentTitle: '',
        hostName: 'mac-A',
        status: 'idle',
        done: true,
      }),
    ).toBe('sub-space · on mac-A · Merged');
  });

  it('draws yours and its parent agent’s as bubbles, the agent’s full width', () => {
    expect(messageSide({ from: 'user' })).toBe('user');
    expect(messageSide({ from: 'space:rs_1' })).toBe('user');
    expect(messageSide({ from: 'claude' })).toBe('assistant');
    expect(messageFrom({ from: 'space:rs_1' })).toBe('From its parent space');
    expect(messageFrom({ from: 'user' })).toBeNull();
  });

  it('turns the read question into a card, takes messages unless gone', () => {
    expect(subSpaceQuestion({ space: 'c', question: null })).toBeNull();
    expect(
      subSpaceQuestion({
        space: 'c',
        question: {
          ask: 'ask-1',
          questions: [{ question: 'Which?', options: [], multi: false }],
        },
      }),
    ).toEqual({
      askId: 'ask-1',
      space: 'c',
      from: '',
      questions: [{ question: 'Which?', options: [], multi: false }],
    });
    expect(subSpaceSendable('running')).toBe(true);
    expect(subSpaceSendable('idle')).toBe(true);
    expect(subSpaceSendable('archived')).toBe(false);
    expect(subSpaceSendable('unknown')).toBe(false);
  });

  it("says Can't reach the host when it is offline or silent, else the refusal", () => {
    expect(readErrorText('mac-A', 'refused by the cloud: fleet.offline')).toBe(
      "Can't reach mac-A",
    );
    expect(
      readErrorText('mac-A', "the other device didn't answer in time"),
    ).toBe("Can't reach mac-A");
    expect(readErrorText('mac-A', 'not connected to the fleet')).toBe(
      "Can't reach mac-A",
    );
    expect(
      readErrorText('mac-A', 'the other device refused: fleet.unknown_space'),
    ).toBe('the other device refused: fleet.unknown_space');
  });
});
