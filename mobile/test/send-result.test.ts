import { describe, expect, it } from 'vitest';
import { sendResult } from '../src/fleet/rules';

describe('a send’s answer from the host', () => {
  it('ran now, or queued with its place, and the row’s id', () => {
    expect(sendResult({ message: 'm1' })).toEqual({
      message: 'm1',
      queued: false,
      position: null,
    });
    expect(sendResult({ message: 'm1', queued: true, position: 1 })).toEqual({
      message: 'm1',
      queued: true,
      position: 1,
    });
  });

  it('never trusts the shape: an odd position is dropped, not shown', () => {
    expect(sendResult(null)).toEqual({
      message: null,
      queued: false,
      position: null,
    });
    expect(sendResult({ queued: 'yes', position: 3 })).toEqual({
      message: null,
      queued: false,
      position: null,
    });
    for (const position of [0, -1, 1.5, '2', null])
      expect(sendResult({ queued: true, position })).toEqual({
        message: null,
        queued: true,
        position: null,
      });
  });

  it('an id is a non-empty string within the cap, else none', () => {
    expect(sendResult({ message: '' }).message).toBeNull();
    expect(sendResult({ message: 7 }).message).toBeNull();
    expect(sendResult({ message: 'x'.repeat(201) }).message).toBeNull();
    expect(sendResult({ message: 'x'.repeat(200) }).message).toBe(
      'x'.repeat(200),
    );
  });
});
