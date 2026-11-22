import { describe, expect, it } from 'vitest';
import { NO_CHOICE, applyChoice } from '../src/telemetry/consent';
import {
  SHARE_ROWS,
  cardChoice,
  needsSharingChoice,
  switchValue,
} from '../src/ui/privacy';
import { screenOfPath } from '../src/shell/paths';

describe('the sharing words', () => {
  it('are the desktop’s', () => {
    expect(SHARE_ROWS.map((r) => r.label)).toEqual([
      'Share usage data',
      'Send error reports',
    ]);
  });

  it('asks only while an available sink has no choice', () => {
    const all = { usage: true, errors: true };
    expect(needsSharingChoice(NO_CHOICE, all, false)).toBe(false);
    expect(needsSharingChoice(NO_CHOICE, all, true)).toBe(true);
    expect(needsSharingChoice(NO_CHOICE, { usage: false, errors: false }, true)).toBe(false);
    const chosen = applyChoice(NO_CHOICE, { usage: false, errors: false });
    expect(needsSharingChoice(chosen, all, true)).toBe(false);
  });

  it('the card can only turn on what the build can send', () => {
    expect(cardChoice({ usage: true, errors: true }, { usage: false, errors: true })).toEqual({
      usage: false,
      errors: true,
    });
  });

  it('a switch shows off until chosen and when unavailable', () => {
    const on = applyChoice(NO_CHOICE, { usage: true });
    expect(switchValue(NO_CHOICE, 'usage', true)).toBe(false);
    expect(switchValue(on, 'usage', true)).toBe(true);
    expect(switchValue(on, 'usage', false)).toBe(false);
    expect(switchValue(on, 'errors', true)).toBe(false);
  });
});

describe('screen names', () => {
  it('drop ids and keep the route', () => {
    expect(screenOfPath('/')).toBe('home');
    expect(screenOfPath('/space/rs_abc')).toBe('space');
    expect(screenOfPath('/sub-space/rs_abc/1a2b3c')).toBe('sub-space');
    expect(screenOfPath('/settings/about?x=1')).toBe('settings/about');
    expect(screenOfPath('/devices')).toBe('devices');
  });
});
