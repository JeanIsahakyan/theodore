import { describe, expect, it } from 'vitest';
import { EphemeralStore } from './EphemeralStore';

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
      status: { available: true, user: null },
    });
    expect(e.account?.user).toBeNull();
  });

  it('setAccount stores a fetched status', () => {
    const e = new EphemeralStore();
    e.setAccount({ available: false, user: null });
    expect(e.account?.available).toBe(false);
  });
});
