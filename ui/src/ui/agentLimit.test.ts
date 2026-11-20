/** Usage limits in words: local wall-clock times, so every expected time is
 *  built from a local `Date`, whatever zone the test runs in. */
import { describe, expect, it } from 'vitest';
import {
  isLimited,
  limitLabel,
  noticeText,
  pauseText,
  resetTime,
} from './agentLimit';

const NOW = new Date(2026, 10, 19, 12, 30).getTime();
const AT_18 = new Date(2026, 10, 19, 18, 0).getTime();
const TOMORROW_18 = new Date(2026, 10, 20, 18, 5).getTime();

describe('resetTime', () => {
  it('today: HH:MM', () => {
    expect(resetTime(AT_18, NOW)).toBe('18:00');
    expect(resetTime(new Date(2026, 10, 19, 7, 5).getTime(), NOW)).toBe(
      '07:05',
    );
  });

  it('another day: the date too', () => {
    expect(resetTime(TOMORROW_18, NOW)).toBe('Nov 20 18:05');
    expect(resetTime(new Date(2027, 0, 2, 9, 0).getTime(), NOW)).toBe(
      'Jan 2 09:00',
    );
  });
});

describe('limitLabel', () => {
  it('nothing reported: no chip', () => {
    expect(limitLabel(null, NOW)).toBeNull();
    expect(limitLabel(undefined, NOW)).toBeNull();
  });

  it('ok', () => {
    expect(limitLabel({ status: 'ok' }, NOW)).toBe('ok');
  });

  it('warning: near limit, with how much is used when known', () => {
    expect(limitLabel({ status: 'warning' }, NOW)).toBe('near limit');
    expect(limitLabel({ status: 'warning', used_pct: 85.4 }, NOW)).toBe(
      'near limit · 85%',
    );
  });

  it('limited: until when it resets', () => {
    expect(limitLabel({ status: 'limited', resets_at: AT_18 }, NOW)).toBe(
      'limited until 18:00',
    );
    expect(limitLabel({ status: 'limited', resets_at: TOMORROW_18 }, NOW)).toBe(
      'limited until Nov 20 18:05',
    );
    expect(limitLabel({ status: 'limited', resets_at: null }, NOW)).toBe(
      'limited',
    );
  });

  it('a limit whose reset passed reads ok', () => {
    const limit = { status: 'limited' as const, resets_at: NOW - 1 };
    expect(limitLabel(limit, NOW)).toBe('ok');
    expect(isLimited(limit, NOW)).toBe(false);
    expect(isLimited({ status: 'limited' }, NOW)).toBe(true);
  });
});

describe('noticeText', () => {
  it('an account switch that continued', () => {
    expect(
      noticeText(
        {
          kind: 'account_switch',
          from: 'Claude · personal',
          to: 'Claude · work',
          resets_at: AT_18,
          continued: true,
        },
        NOW,
      ),
    ).toBe(
      'Claude · personal hit its limit (resets 18:00): continuing on Claude · work',
    );
  });

  it("an account switch that didn't continue, no reset known", () => {
    expect(
      noticeText(
        {
          kind: 'account_switch',
          from: 'Claude · personal',
          to: 'Codex',
          resets_at: null,
          continued: false,
        },
        NOW,
      ),
    ).toBe('Claude · personal hit its limit: the next turn runs on Codex');
  });

  it('a limit hit', () => {
    expect(
      noticeText(
        { kind: 'limit_hit', account: 'Claude · work', resets_at: AT_18 },
        NOW,
      ),
    ).toBe('Claude · work hit its limit (resets 18:00)');
  });
});

describe('pauseText', () => {
  it('with and without a reset', () => {
    expect(pauseText(AT_18, NOW)).toBe(
      'Paused: limits reset at 18:00 · continues automatically',
    );
    expect(pauseText(null, NOW)).toBe('Paused: usage limits reached');
  });
});
