import { beforeEach, describe, expect, it } from 'vitest';
import type { RootStore } from '../stores/RootStore';
import { UiStore } from '../stores/UiStore';
import { runMenu } from './menu';

beforeEach(() => localStorage.clear());

describe('runMenu: Go', () => {
  const store = () => ({ ui: new UiStore() }) as unknown as RootStore;

  it('opens Pull requests, keeping its filter', () => {
    const s = store();
    s.ui.setPrsFilter('merged');
    runMenu(s, 'go-prs');
    expect(s.ui.route).toEqual({ name: 'prs' });
    expect(s.ui.prsFilter).toBe('merged');
  });

  it('opens Pull requests on Mine', () => {
    const s = store();
    runMenu(s, 'go-mine');
    expect(s.ui.route).toEqual({ name: 'prs' });
    expect(s.ui.prsFilter).toBe('mine');
  });
});
