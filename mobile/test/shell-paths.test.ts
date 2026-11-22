import { describe, expect, it } from 'vitest';
import {
  SHEET_PATHS,
  isSheetPath,
  screenOfPath,
  spaceIdFromPath,
} from '../src/shell/paths';

describe('spaceIdFromPath', () => {
  it('reads the space on screen', () => {
    expect(spaceIdFromPath('/space/sp_1')).toBe('sp_1');
    expect(spaceIdFromPath('/space/a%20b?x=1')).toBe('a b');
    expect(spaceIdFromPath('/space/%E0%A4%A')).toBe('%E0%A4%A');
    expect(spaceIdFromPath('/')).toBeNull();
    expect(spaceIdFromPath('/start')).toBeNull();
  });
});

describe('screenOfPath', () => {
  it('names the screen and never an id', () => {
    expect(screenOfPath('/')).toBe('home');
    expect(screenOfPath('/space/rs_1')).toBe('space');
    expect(screenOfPath('/s/3f2a9c1b0d4e')).toBe('s');
    expect(screenOfPath('/sub-space/rs_1/abc')).toBe('sub-space');
    expect(screenOfPath('/file/rs_1?path=a.ts')).toBe('file');
    expect(screenOfPath('/settings/about')).toBe('settings/about');
    expect(screenOfPath('/devices')).toBe('devices');
  });
});

describe('isSheetPath', () => {
  it('knows every sheet route, with or without a query', () => {
    for (const p of Object.values(SHEET_PATHS)) {
      expect(isSheetPath(p)).toBe(true);
      expect(isSheetPath(`${p}?space=rs_1`)).toBe(true);
    }
    expect(isSheetPath('/')).toBe(false);
    expect(isSheetPath('/space/rs_1')).toBe(false);
    expect(isSheetPath('/settings')).toBe(false);
  });
});
