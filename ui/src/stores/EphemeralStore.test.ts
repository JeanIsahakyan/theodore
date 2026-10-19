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
