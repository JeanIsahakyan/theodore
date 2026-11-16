import { describe, expect, it } from 'vitest';
import type { FleetAgentInfo } from '../src/gen/fleet';
import {
  MAX_AGENT_MODELS,
  MAX_AGENTS,
  MAX_EFFORT_CHARS,
  MAX_MODEL_ID_CHARS,
  PROTOCOL_VERSION,
} from '../src/fleet/limits';
import { BadMessage, parseClient, peekRequest } from '../src/fleet/wire';
import { Harness, info } from './fleet-harness';

const claude: FleetAgentInfo = {
  id: 'claude',
  label: 'Claude',
  default_model: 'opus',
  default_effort: 'high',
  models: [
    {
      id: 'opus',
      label: 'Opus',
      efforts: ['low', 'medium', 'high'],
      default_effort: 'medium',
    },
  ],
};

const announce = (agents: unknown) =>
  JSON.stringify({ type: 'announce', info: { ...info('mac'), agents } });

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof BadMessage ? e.code : String(e);
  }
  return null;
};

const body = (op: Record<string, unknown>) =>
  JSON.stringify({
    req_id: 'r1',
    origin_device: 'dev_a',
    target_device: 'dev_b',
    target_key: 'k',
    issued_at_ms: 1,
    op,
  });

describe('device info agents', () => {
  it('reads the agents a host lists, and none from an older one', () => {
    const m = parseClient(announce([claude]), PROTOCOL_VERSION);
    expect(m).toEqual({
      type: 'announce',
      info: { ...info('mac'), agents: [claude] },
    });
    const old = { ...info('mac') } as Record<string, unknown>;
    delete old.agents;
    const parsed = parseClient(
      JSON.stringify({ type: 'announce', info: old }),
      PROTOCOL_VERSION,
    );
    expect(parsed).toMatchObject({ info: { agents: [] } });
  });

  it('drops fields it does not know', () => {
    const m = parseClient(
      announce([
        { ...claude, secret: 'x', models: [{ ...claude.models![0], more: 1 }] },
      ]),
      PROTOCOL_VERSION,
    );
    expect(m).toEqual({
      type: 'announce',
      info: { ...info('mac'), agents: [claude] },
    });
  });

  it('bounds counts and lengths', () => {
    const many = Array.from({ length: MAX_AGENTS + 1 }, () => claude);
    expect(code(() => parseClient(announce(many)))).toBe('fleet.bad_message');
    const models = Array.from(
      { length: MAX_AGENT_MODELS + 1 },
      () => claude.models![0],
    );
    expect(code(() => parseClient(announce([{ ...claude, models }])))).toBe(
      'fleet.bad_message',
    );
    const longId = 'x'.repeat(MAX_MODEL_ID_CHARS + 1);
    expect(
      code(() =>
        parseClient(
          announce([
            { ...claude, models: [{ ...claude.models![0], id: longId }] },
          ]),
        ),
      ),
    ).toBe('fleet.bad_message');
    const longEffort = 'e'.repeat(MAX_EFFORT_CHARS + 1);
    expect(
      code(() =>
        parseClient(
          announce([
            {
              ...claude,
              models: [{ ...claude.models![0], efforts: [longEffort] }],
            },
          ]),
        ),
      ),
    ).toBe('fleet.bad_message');
    expect(code(() => parseClient(announce([{ ...claude, id: 7 }])))).toBe(
      'fleet.bad_message',
    );
    expect(code(() => parseClient(announce('claude')))).toBe(
      'fleet.bad_message',
    );
  });

  it('keeps the whole info within its size', () => {
    const label = 'L'.repeat(64);
    const models = Array.from({ length: MAX_AGENT_MODELS }, (_, i) => ({
      id: `${'m'.repeat(60)}${i}`,
      label,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'medium',
    }));
    const agents = Array.from({ length: MAX_AGENTS }, (_, i) => ({
      ...claude,
      id: `a${i}`,
      models,
    }));
    expect(code(() => parseClient(announce(agents)))).toBe('fleet.too_large');
  });

  it('lists a host’s agents to the user’s other devices', async () => {
    const h = new Harness();
    const mac1 = await h.device('user_1', 'mac1');
    const mac2 = await h.device('user_1', 'mac2');
    mac2.infoOver = { agents: [claude] };
    await mac1.connect();
    await mac2.connect();
    const lists = mac1.take('devices');
    const last = lists[lists.length - 1]!;
    const listed = last.devices.find((d) => d.device_id === mac2.id);
    expect(listed?.info.agents).toEqual([claude]);
  });
});

describe('request picks', () => {
  const start = {
    op: 'start_space',
    space: 'rs_1',
    project_id: 'p1',
    goal: 'g',
    mode: 'edit',
    parent: null,
    depth: 0,
  };
  const send = { op: 'send', space: 'rs_1', text: 'go', mode: null };

  it('routes ops with and without picks', () => {
    for (const op of [
      start,
      send,
      { ...start, agent: 'codex', model: 'gpt-5.5', effort: 'high' },
      { ...send, agent: 'claude', model: null, effort: 'low' },
    ]) {
      expect(peekRequest(body(op)).space).toBe('rs_1');
    }
  });

  it('refuses a pick past its bounds', () => {
    for (const op of [
      { ...start, agent: 'a'.repeat(33) },
      { ...send, model: 'm'.repeat(MAX_MODEL_ID_CHARS + 1) },
      { ...send, effort: 'e'.repeat(MAX_EFFORT_CHARS + 1) },
      { ...send, effort: 3 },
      { ...start, model: '' },
    ]) {
      expect(code(() => peekRequest(body(op)))).toBe('fleet.bad_message');
    }
  });
});
