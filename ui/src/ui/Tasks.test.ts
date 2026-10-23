import { describe, expect, it } from 'vitest';
import { isMe } from './Tasks';

describe('isMe', () => {
  it('matches the viewer login and the pre-login placeholder', () => {
    expect(isMe('sam', 'sam')).toBe(true);
    expect(isMe('me', 'sam')).toBe(true);
    expect(isMe('me', null)).toBe(true);
    expect(isMe('lee', 'sam')).toBe(false);
    expect(isMe('sam', null)).toBe(false);
  });
});
