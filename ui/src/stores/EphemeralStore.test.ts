import { describe, expect, it } from 'vitest';
import { EphemeralStore } from './EphemeralStore';

describe('EphemeralStore config PR', () => {
  it('a config_pr event becomes a toast that opens the PR', () => {
    const e = new EphemeralStore();
    e.handle({
      type: 'config_pr',
      project: 'github:acme/widget',
      number: 7,
      url: 'https://github.com/acme/widget/pull/7',
    });
    expect(e.toasts).toHaveLength(1);
    expect(e.toasts[0]).toMatchObject({
      level: 'info',
      text: 'Config PR #7 is open',
    });
    expect(e.toasts[0]!.action?.label).toBe('Open');
  });
});

describe('EphemeralStore stalled tracking', () => {
  it('marks a run stalled on run_stalled', () => {
    const e = new EphemeralStore();
    e.handle({ type: 'run_stalled', run: 'r1', agent: 'claude' });
    expect(e.stalled.has('r1')).toBe(true);
  });

  it('clears stalled once the run produces more text', () => {
    const e = new EphemeralStore();
    e.handle({ type: 'run_stalled', run: 'r1', agent: 'claude' });
    e.handle({ type: 'agent_delta', run: 'r1', agent: 'claude', text: 'hi' });
    expect(e.stalled.has('r1')).toBe(false);
  });

  it('clears stalled once the run logs a new line', () => {
    const e = new EphemeralStore();
    e.handle({ type: 'run_stalled', run: 'r1', agent: 'claude' });
    e.handle({ type: 'run_log', run: 'r1', agent: 'claude', line: 'tool: x' });
    expect(e.stalled.has('r1')).toBe(false);
  });

  it('does not affect other runs', () => {
    const e = new EphemeralStore();
    e.handle({ type: 'run_stalled', run: 'r1', agent: 'claude' });
    e.handle({ type: 'run_stalled', run: 'r2', agent: 'codex' });
    e.handle({ type: 'agent_delta', run: 'r1', agent: 'claude', text: 'hi' });
    expect(e.stalled.has('r1')).toBe(false);
    expect(e.stalled.has('r2')).toBe(true);
  });

  it('clearRun also clears stalled', () => {
    const e = new EphemeralStore();
    e.handle({ type: 'run_stalled', run: 'r1', agent: 'claude' });
    e.clearRun('r1');
    expect(e.stalled.has('r1')).toBe(false);
  });
});

describe('EphemeralStore account', () => {
  it('starts unknown and follows account_status events', () => {
    const e = new EphemeralStore();
    expect(e.account).toBeNull();
    e.handle({
      type: 'account_status',
      status: {
        available: true,
        required: true,
        session_ended: false,
        user: {
          id: 'u',
          email: 'ada@example.com',
          name: null,
          avatar_url: null,
        },
      },
    });
    expect(e.account?.user?.email).toBe('ada@example.com');
    e.handle({
      type: 'account_status',
      status: {
        available: true,
        required: true,
        user: null,
        session_ended: true,
      },
    });
    expect(e.account?.user).toBeNull();
  });

  it('setAccount stores a fetched status', () => {
    const e = new EphemeralStore();
    e.setAccount({
      available: false,
      required: false,
      user: null,
      session_ended: false,
    });
    expect(e.account?.available).toBe(false);
  });

  it('locks the gate while signed out where sign-in is required', () => {
    const e = new EphemeralStore();
    expect(e.accountGate).toBe('unknown');
    const out = {
      available: true,
      required: true,
      user: null,
      session_ended: false,
    };
    e.setAccount(out);
    expect(e.accountGate).toBe('locked');
    e.setAccount({
      ...out,
      user: { id: 'u', email: 'a@b.co', name: null, avatar_url: null },
    });
    expect(e.accountGate).toBe('open');
    // The session ended: the event closes it again.
    e.handle({
      type: 'account_status',
      status: { ...out, session_ended: true },
    });
    expect(e.accountGate).toBe('locked');
  });
});

describe('EphemeralStore space logs', () => {
  const line = (at: number, text: string) => ({
    kind: 'setup' as const,
    line: text,
    stderr: false,
    at,
  });

  it('buffers space_log lines per space and seeds from the tail', () => {
    const e = new EphemeralStore();
    e.handle({ type: 'space_log', space: 's1', line: line(3, 'live') });
    e.handle({ type: 'space_log', space: 's2', line: line(1, 'other') });
    e.seedSpaceLogs('s1', [line(1, 'a'), line(2, 'b')]);
    expect(e.spaceLogs.get('s1')?.map((l) => l.line)).toEqual([
      'a',
      'b',
      'live',
    ]);
    expect(e.spaceLogs.get('s2')).toHaveLength(1);
  });
});
