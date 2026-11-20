import { describe, expect, it } from 'vitest';
import vectors from '../src/gen/fleet-vectors.json';

// The Rust-made signing vectors are present; the fleet client's tests check
// its crypto against them.
describe('fleet vectors', () => {
  it('has every domain tag', () => {
    expect(Object.keys(vectors.tags).sort()).toEqual(
      [
        'ask',
        'confirm',
        'delegate',
        'event',
        'hello',
        'reply',
        'request',
      ].sort(),
    );
  });
});
