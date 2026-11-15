import { describe, expect, it } from 'vitest';
import { spaceIdFromPath } from '../src/shell/paths';

describe('spaceIdFromPath', () => {
  it('reads the space on screen', () => {
    expect(spaceIdFromPath('/space/sp_1')).toBe('sp_1');
    expect(spaceIdFromPath('/space/a%20b?x=1')).toBe('a b');
    expect(spaceIdFromPath('/space/%E0%A4%A')).toBe('%E0%A4%A');
    expect(spaceIdFromPath('/')).toBeNull();
    expect(spaceIdFromPath('/start')).toBeNull();
  });
});
