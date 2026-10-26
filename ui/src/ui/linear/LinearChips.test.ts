import { describe, expect, it } from 'vitest';
import { chipColorFor } from './LinearChips';

describe('chipColorFor', () => {
  it('colors a completed issue success', () => {
    expect(chipColorFor('completed')).toBe('success');
  });

  it('colors a canceled issue danger', () => {
    expect(chipColorFor('canceled')).toBe('danger');
  });

  it('falls back to default for every other state type', () => {
    expect(chipColorFor('started')).toBe('default');
    expect(chipColorFor('backlog')).toBe('default');
    expect(chipColorFor('unstarted')).toBe('default');
    expect(chipColorFor('triage')).toBe('default');
  });

  it('falls back to default for an unrecognized future state type', () => {
    expect(chipColorFor('some_new_state_linear_adds_later')).toBe('default');
  });
});
