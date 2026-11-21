import { describe, expect, it } from 'vitest';
import { sendResult } from '../src/fleet/rules';

describe('a send’s answer from the host', () => {
  it('ran now, or queued with its place', () => {
    expect(sendResult({ message: 'm1' })).toEqual({
      queued: false,
      position: null,
    });
    expect(sendResult({ message: 'm1', queued: true, position: 1 })).toEqual({
      queued: true,
      position: 1,
    });
  });

  it('never trusts the shape: an odd position is dropped, not shown', () => {
    expect(sendResult(null)).toEqual({ queued: false, position: null });
    expect(sendResult({ queued: 'yes', position: 3 })).toEqual({
      queued: false,
      position: null,
    });
    for (const position of [0, -1, 1.5, '2', null])
      expect(sendResult({ queued: true, position })).toEqual({
        queued: true,
        position: null,
      });
  });
});
