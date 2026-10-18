import { describe, expect, it } from 'vitest';
import { budgetStatus } from './SidePanel';

describe('budgetStatus', () => {
  it('has no bar when there is no budget set', () => {
    expect(budgetStatus(3, null)).toEqual({
      pct: 0,
      tone: 'default',
      over: false,
    });
  });

  it('has no bar when the budget is zero or negative', () => {
    expect(budgetStatus(0, 0)).toEqual({ pct: 0, tone: 'default', over: false });
    expect(budgetStatus(1, -5)).toEqual({
      pct: 0,
      tone: 'default',
      over: false,
    });
  });

  it('is the default tone comfortably under the limit', () => {
    expect(budgetStatus(1, 10)).toEqual({ pct: 10, tone: 'default', over: false });
  });

  it('turns warning past 75%', () => {
    expect(budgetStatus(7.6, 10)).toEqual({
      pct: 76,
      tone: 'warning',
      over: false,
    });
  });

  it('is not yet warning exactly at 75%', () => {
    expect(budgetStatus(7.5, 10).tone).toBe('default');
  });

  it('turns danger and reports over at the limit', () => {
    expect(budgetStatus(10, 10)).toEqual({ pct: 100, tone: 'danger', over: true });
  });

  it('clamps the bar at 100% past the limit', () => {
    expect(budgetStatus(25, 10)).toEqual({
      pct: 100,
      tone: 'danger',
      over: true,
    });
  });
});
