import { describe, expect, it } from 'vitest';
import { mockAgents } from '../src/dev/mock';
import {
  NO_PICK,
  effortLabel,
  pickAgent,
  pickEffort,
  pickModel,
  running,
  runningLabel,
  sendPicks,
  spaceOwn,
  startPicks,
} from '../src/ui/agents';

const agents = mockAgents;

describe("what runs on a host (its defaults, the space's own, a pick)", () => {
  it('lists nothing: no chip', () => {
    expect(running([], NO_PICK)).toBeNull();
    expect(startPicks([], pickAgent('claude'))).toEqual({});
    expect(sendPicks([], pickAgent('claude'), NO_PICK)).toEqual({});
  });

  it("nothing picked: the host's default agent, model and effort", () => {
    const r = running(agents, NO_PICK)!;
    expect(r.agent.id).toBe('claude');
    expect(r.model?.id).toBe('claude-opus-4-1');
    expect(r.effort).toBe('high');
    // Claude's levels end with Ultracode.
    expect(r.levels.at(-1)).toBe('ultracode');
    expect(runningLabel(r)).toBe('Opus 4.1 · High');
  });

  it("another agent: its own defaults; a model's when it isn't the default", () => {
    const codex = running(agents, pickAgent('codex'))!;
    expect(runningLabel(codex)).toBe('GPT-5 Codex · Medium');
    expect(codex.levels).toEqual(['low', 'medium', 'high']);
    const haiku = running(agents, {
      ...NO_PICK,
      model: 'claude-haiku-4-5',
    })!;
    expect(haiku.levels).toEqual([]);
    expect(haiku.effort).toBeNull();
    expect(runningLabel(haiku)).toBe('Haiku 4.5');
  });

  it("the space's own while nothing is picked, an alias read as its model", () => {
    const own = spaceOwn({ agent: 'claude', model: 'sonnet', effort: 'max' });
    const r = running(agents, NO_PICK, own)!;
    expect(r.model?.id).toBe('claude-sonnet-4-5');
    expect(r.effort).toBe('max');
    // A pick wins; another agent drops the space's model and effort.
    expect(running(agents, pickEffort(NO_PICK, 'low'), own)!.effort).toBe(
      'low',
    );
    expect(runningLabel(running(agents, pickAgent('codex'), own)!)).toBe(
      'GPT-5 Codex · Medium',
    );
  });

  it('an agent picked resets model and effort; a model drops a level it lacks', () => {
    const p = pickModel(
      agents,
      pickEffort(NO_PICK, 'xhigh'),
      NO_PICK,
      'claude-sonnet-4-5',
    );
    expect(p).toEqual({
      agent: null,
      model: 'claude-sonnet-4-5',
      effort: 'xhigh',
    });
    expect(pickModel(agents, p, NO_PICK, 'claude-haiku-4-5')).toEqual({
      agent: null,
      model: 'claude-haiku-4-5',
      effort: null,
    });
    expect(pickAgent('codex')).toEqual({
      agent: 'codex',
      model: null,
      effort: null,
    });
  });

  it('labels levels', () => {
    expect(effortLabel('xhigh')).toBe('Extra high');
    expect(effortLabel('ultracode')).toBe('Ultracode');
    expect(effortLabel('turbo')).toBe('Turbo');
  });
});

describe('what a start names', () => {
  it("nothing picked: nothing, the host's defaults run", () => {
    expect(startPicks(agents, NO_PICK)).toEqual({});
  });

  it('a pick names the agent shown and only what was picked', () => {
    expect(startPicks(agents, pickAgent('codex'))).toEqual({ agent: 'codex' });
    expect(
      startPicks(agents, { ...NO_PICK, model: 'claude-sonnet-4-5' }),
    ).toEqual({ agent: 'claude', model: 'claude-sonnet-4-5' });
    expect(startPicks(agents, pickEffort(NO_PICK, 'max'))).toEqual({
      agent: 'claude',
      effort: 'max',
    });
  });

  it('drops what the host no longer lists', () => {
    expect(startPicks(agents, pickAgent('gemini'))).toEqual({});
    expect(
      startPicks(agents, {
        agent: 'codex',
        model: 'claude-opus-4-1',
        effort: null,
      }),
    ).toEqual({ agent: 'codex' });
    expect(
      startPicks(agents, { agent: 'codex', model: null, effort: 'max' }),
    ).toEqual({ agent: 'codex' });
  });
});

describe('what a send names', () => {
  const own = spaceOwn({
    agent: 'claude',
    model: 'claude-opus-4-1',
    effort: 'high',
  });

  it("nothing picked: nothing, the space's own stays", () => {
    expect(sendPicks(agents, NO_PICK, own)).toEqual({});
  });

  it("the agent only when it isn't the space's", () => {
    expect(sendPicks(agents, pickEffort(NO_PICK, 'low'), own)).toEqual({
      effort: 'low',
    });
    expect(sendPicks(agents, pickAgent('claude'), own)).toEqual({});
    expect(sendPicks(agents, pickAgent('codex'), own)).toEqual({
      agent: 'codex',
    });
    expect(
      sendPicks(
        agents,
        pickModel(agents, NO_PICK, own, 'claude-sonnet-4-5'),
        own,
      ),
    ).toEqual({ model: 'claude-sonnet-4-5' });
  });

  it("names the agent shown when the space's isn't known", () => {
    expect(sendPicks(agents, pickEffort(NO_PICK, 'low'), NO_PICK)).toEqual({
      agent: 'claude',
      effort: 'low',
    });
  });
});
