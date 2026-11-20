import { describe, expect, it } from 'vitest';
import { pinName, projectName } from '../src/mcp/text';

describe('names as shown to Claude', () => {
  it('a project keeps owner/repo; a device name drops the slash', () => {
    expect(projectName('JeanIsahakyan/kdb')).toBe('JeanIsahakyan/kdb');
    expect(projectName('core.loc')).toBe('core.loc');
    expect(projectName('<b>x</b>')).toBe('bx/b');
    expect(projectName('')).toBe('project');
    expect(pinName('a/b')).toBe('ab');
  });
});
